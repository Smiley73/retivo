/**
 * Shared shape used by chart hover tooltips on the Balance Projection
 * and Expenses pages to render "<First> (age N)" per household
 * member. `birthYear` is the integer calendar year from the member's
 * ISO birthdate; tooltips compute the rendered age as
 * `pointYear - birthYear` ("the age the member turns this calendar
 * year"), matching the convention the life-expectancy markers use.
 */
export interface TooltipMember {
  firstName: string;
  birthYear: number;
}
